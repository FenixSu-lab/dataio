create table if not exists sale_order (
  id bigint primary key auto_increment,
  customer_id varchar(64) not null,
  order_no varchar(64) not null,
  amount decimal(18, 2) not null,
  mobile varchar(32),
  created_at timestamp not null default current_timestamp
);

insert into sale_order (customer_id, order_no, amount, mobile)
values ('C001', 'SO-001', 1280.50, '13800000000');
